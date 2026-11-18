// barcode2d.ts — the 2D symbologies of PCB_BARCODE (QR Code, Micro QR Code, Data Matrix ECC 200), encoded as the
// Zint library KiCad links encodes them (thirdparty/zint/backend/qr.c, dmatrix.c): the same mode optimisation, version
// choice, Reed-Solomon blocks, module placement and mask scoring, so a (barcode …) item draws the modules pcbnew does.
// Data Matrix follows Zint's default minimal encodation (dm_minimalenc: the cheapest mix of ASCII, C40, Text, X12,
// EDIFACT and Base 256 with its end-of-data rules), so it picks the same codewords and symbol size.

/** A module matrix: rows[y][x] true = dark; row 0 is the top. */
export interface Matrix2D { rows: boolean[][]; error?: undefined }
export interface Barcode2DError { rows?: undefined; error: string }
export type Barcode2DResult = Matrix2D | Barcode2DError;

// ---- Reed-Solomon over GF(256) (reedsol.c) ----
function gf(poly: number) {
  const alog = new Array<number>(512), log = new Array<number>(256).fill(0);
  let v = 1;
  for (let i = 0; i < 255; i++) { alog[i] = v; log[v] = i; v <<= 1; if (v & 0x100) v ^= poly; }
  for (let i = 255; i < 512; i++) alog[i] = alog[i - 255];
  return { alog, log };
}
const GF_QR = gf(0x11d), GF_DM = gf(0x12d);
/** rs_init_code + rs_encode: nsym check symbols of `data`, highest power first; roots alpha^index … */
function rsEncode(G: ReturnType<typeof gf>, data: number[], nsym: number, index: number): number[] {
  const { alog, log } = G;
  const poly = new Array<number>(nsym + 1).fill(0); poly[0] = 1;
  for (let i = 1; i <= nsym; i++) {
    poly[i] = 1;
    for (let k = i - 1; k > 0; k--) { if (poly[k]) poly[k] = alog[log[poly[k]] + index]; poly[k] ^= poly[k - 1]; }
    poly[0] = alog[log[poly[0]] + index]; index++;
  }
  const res = new Array<number>(nsym).fill(0);
  for (const d of data) {
    const m = res[nsym - 1] ^ d;
    for (let k = nsym - 1; k > 0; k--) res[k] = res[k - 1] ^ (m && poly[k] ? alog[log[m] + log[poly[k]]] : 0);
    res[0] = m && poly[0] ? alog[log[m] + log[poly[0]]] : 0;
  }
  return res.reverse();
}

// ---- QR / Micro QR (qr.c) ----
const QR_ALPHA = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const QR_DATA_CW = [
  [19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 589, 647, 721, 795, 861, 932, 1006, 1094, 1174, 1276, 1370, 1468, 1531, 1631, 1735, 1843, 1955, 2071, 2191, 2306, 2434, 2566, 2702, 2812, 2956],
  [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669, 714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373, 1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334],
  [13, 22, 34, 48, 62, 76, 88, 110, 132, 154, 180, 206, 244, 261, 295, 325, 367, 397, 445, 485, 512, 568, 614, 664, 718, 754, 808, 871, 911, 985, 1033, 1115, 1171, 1231, 1286, 1354, 1426, 1502, 1582, 1666],
  [9, 16, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 223, 253, 283, 313, 341, 385, 406, 442, 464, 514, 538, 596, 628, 661, 701, 745, 793, 845, 901, 961, 986, 1054, 1096, 1142, 1222, 1276],
];
const QR_TOTAL_CW = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706];
const QR_BLOCKS = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const QR_ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90], [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118], [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146], [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170]];
const QR_FORMAT = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0, 0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976, 0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b, 0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed];
const QR_VERSION_INFO = [0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d, 0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9, 0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75, 0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64, 0x27541, 0x28c69];
const MQR_FORMAT = [0x4445, 0x4172, 0x4e2b, 0x4b1c, 0x55ae, 0x5099, 0x5fc0, 0x5af7, 0x6793, 0x62a4, 0x6dfd, 0x68ca, 0x7678, 0x734f, 0x7c16, 0x7921, 0x06de, 0x03e9, 0x0cb0, 0x0987, 0x1735, 0x1202, 0x1d5b, 0x186c, 0x2508, 0x203f, 0x2f66, 0x2a51, 0x34e3, 0x31d4, 0x3e8d, 0x3bba];
/** microqr_data[ecc][version] = [data bits, data codewords, ecc codewords] */
const MQR_DATA = [[[20, 3, 2], [40, 5, 5], [84, 11, 6], [128, 16, 8]], [[0, 0, 0], [32, 4, 6], [68, 9, 8], [112, 14, 10]], [[0, 0, 0], [0, 0, 0], [0, 0, 0], [80, 10, 14]]];

type Mode = "N" | "A" | "B";
const MODES: Mode[] = ["N", "A", "B"];
/** Version key: 1..40 QR, -1..-4 Micro QR M1..M4. */
function cciBits(v: number, m: Mode): number {
  if (v > 0) { const r = v < 10 ? [10, 9, 8] : v < 27 ? [12, 11, 16] : [14, 13, 16]; return r[MODES.indexOf(m)]; }
  return [[3, 0, 0], [4, 3, 0], [5, 4, 4], [6, 5, 5]][-v - 1][MODES.indexOf(m)];
}
const modeBits = (v: number) => v > 0 ? 4 : -v - 1;
const modeIndicator = (v: number, m: Mode) => v > 0 ? { N: 1, A: 2, B: 4 }[m] : { N: 0, A: 1, B: 2 }[m];
const MQR_MAX = 774;   // (128 + 1) * QR_MULT: a mode Micro QR versions M1 / M2 do not have

/** qr_define_mode: Nayuki's optimal mode segmentation, in sixths of a bit, as Zint costs it. */
function defineMode(d: number[], v: number): Mode[] {
  const n = d.length, m1 = v === -1, m2 = v === -2;
  const head = v > 0 ? MODES.map((m) => (cciBits(v, m) + 4) * 6)
    : [[18, MQR_MAX, MQR_MAX], [30, 24, MQR_MAX], [42, 36, 36], [54, 48, 48]][-v - 1];
  let prev = head.slice();
  const charModes: (Mode | "")[][] = [];
  let nEnd = 0, nCost = 0, aEnd = 0, aCost = 0;
  const isDigit = (c: number) => c >= 48 && c <= 57, isAlpha = (c: number) => c < 128 && QR_ALPHA.indexOf(String.fromCharCode(c)) >= 0;
  for (let i = 0; i < n; i++) {
    const cur = [0, 0, 0], cm: (Mode | "")[] = ["", "", ""];
    // qr_in_numeric
    let inN = false;
    if (i < nEnd) inN = true;
    else { let j = i; while (j < n && j < i + 3 && isDigit(d[j])) j++; const cnt = j - i; if (cnt) { nEnd = j; nCost = cnt === 1 ? 24 : cnt === 2 ? 21 : 20; inN = true; } else nEnd = 0; }
    if (inN) { cur[0] = prev[0] + nCost; cm[0] = "N"; }
    // qr_in_alpha
    let inA = false; const last = i + 1 === n;
    if (i < aEnd) { aCost = !last ? 33 : 36; inA = true; }
    else if (isAlpha(d[i])) { const two = !last && isAlpha(d[i + 1]); aEnd = two ? i + 2 : i + 1; aCost = two ? 33 : 36; inA = true; }
    else aEnd = 0;
    if (inA) { cur[1] = prev[1] + (m1 ? MQR_MAX : aCost); cm[1] = "A"; }
    cur[2] = prev[2] + (m1 || m2 ? MQR_MAX : 48); cm[2] = "B";
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
      if (j !== k && cm[k]) { const nc = cur[k] + head[j]; if (!cm[j] || nc < cur[j]) { cur[j] = nc; cm[j] = MODES[k]; } }
    }
    charModes.push(cm); prev = cur;
  }
  let best = 0; for (let j = 1; j < 3; j++) if (prev[j] < prev[best]) best = j;
  const out: Mode[] = new Array(n); let curMode: Mode = MODES[best];
  for (let i = n - 1; i >= 0; i--) { const mm = charModes[i][MODES.indexOf(curMode)] as Mode; out[i] = mm; curMode = mm; }
  return out;
}

class Bits { b: number[] = []; put(v: number, n: number) { for (let i = n - 1; i >= 0; i--) this.b.push((v >>> i) & 1); } get length() { return this.b.length; } }

/** The data bit stream for version v: ECI header, then each run of one mode. */
function qrStream(d: number[], v: number, eci: number): { bits: Bits; modes: Mode[] } {
  const modes = defineMode(d, v), bits = new Bits();
  if (eci) { bits.put(7, 4); bits.put(eci, 8); }
  for (let i = 0; i < d.length;) {
    const m = modes[i]; let j = i; while (j < d.length && modes[j] === m) j++;
    const seg = d.slice(i, j);
    bits.put(modeIndicator(v, m), modeBits(v)); bits.put(seg.length, cciBits(v, m));
    if (m === "N") { for (let k = 0; k < seg.length; k += 3) { const g = seg.slice(k, k + 3); bits.put(parseInt(String.fromCharCode(...g), 10), g.length * 3 + 1); } }
    else if (m === "A") { for (let k = 0; k < seg.length; k += 2) { const a = QR_ALPHA.indexOf(String.fromCharCode(seg[k])); if (k + 1 < seg.length) bits.put(a * 45 + QR_ALPHA.indexOf(String.fromCharCode(seg[k + 1])), 11); else bits.put(a, 6); } }
    else for (const c of seg) bits.put(c, 8);
    i = j;
  }
  return { bits, modes };
}

/** The text as Zint's QR input: Latin-1 when every character fits, else UTF-8 bytes under ECI 26 (KiCad sets ECI_UTF8). */
function qrInput(text: string, allowEci: boolean): { d: number[]; eci: number } | null {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  if (cps.every((c) => c < 128)) return { d: cps, eci: 0 };
  if (!allowEci) return cps.every((c) => c < 256) ? { d: cps, eci: 0 } : null;
  return { d: [...new TextEncoder().encode(text)], eci: 26 };
}

/** The standard QR grid: flags per module, 0x10 / 0x20 = function (not masked), bit 0 = dark. */
function qrFunctionGrid(v: number): { size: number; g: number[] } {
  const size = 17 + 4 * v, g = new Array<number>(size * size).fill(0);
  for (let i = 0; i < size; i++) { const t = i % 2 === 0 ? 0x21 : 0x20; g[6 * size + i] = t; g[i * size + 6] = t; }
  const finder = (x: number, y: number) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      g[(y + r) * size + x + c] = dark ? 0x11 : 0x10;
    }
  };
  finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
  for (let i = 0; i < 7; i++) {
    g[7 * size + i] = 0x10; g[i * size + 7] = 0x10; g[7 * size + size - 1 - i] = 0x10; g[i * size + size - 8] = 0x10;
    g[(size - 8) * size + i] = 0x10; g[(size - 1 - i) * size + 7] = 0x10;
  }
  g[7 * size + 7] = 0x10; g[7 * size + size - 8] = 0x10; g[(size - 8) * size + 7] = 0x10;
  const al = QR_ALIGN[v - 1];
  for (const ay of al) for (const ax of al) {
    if (g[ay * size + ax] & 0x10) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) g[(ay + r) * size + ax + c] = (Math.max(Math.abs(r), Math.abs(c)) !== 1) ? 0x11 : 0x10;
  }
  for (let i = 0; i < 8; i++) { g[8 * size + i] |= 0x20; g[i * size + 8] |= 0x20; g[8 * size + size - 1 - i] = 0x20; g[(size - 1 - i) * size + 8] = 0x20; }
  g[8 * size + 8] |= 0x20; g[(size - 8) * size + 8] = 0x21;
  if (v >= 7) {
    const info = QR_VERSION_INFO[v - 7];
    for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) {
      const bit = 0x20 | ((info >> (i * 3 + k)) & 1);
      g[(size - 11 + k) * size + i] = bit; g[i * size + size - 11 + k] = bit;
    }
  }
  return { size, g };
}

function qrFormatInto(g: number[], size: number, ecc: number, pattern: number) {
  const fmt = pattern | [0x08, 0x00, 0x18, 0x10][ecc], seq = QR_FORMAT[fmt];
  for (let i = 0; i < 6; i++) g[i * size + 8] |= (seq >> i) & 1;
  for (let i = 0; i < 8; i++) g[8 * size + size - i - 1] |= (seq >> i) & 1;
  for (let i = 0; i < 6; i++) g[8 * size + 5 - i] |= (seq >> (i + 9)) & 1;
  for (let i = 0; i < 7; i++) g[(size - 7 + i) * size + 8] |= (seq >> (i + 8)) & 1;
  g[7 * size + 8] |= (seq >> 6) & 1; g[8 * size + 8] |= (seq >> 7) & 1; g[8 * size + 7] |= (seq >> 8) & 1;
}

/** qr_evaluate: the four penalty rules as Zint scores them. */
function qrPenalty(l: number[], size: number): number {
  let result = 0, dark = 0;
  for (let x = 0; x < size; x++) {
    let block = 0, state = 0;
    for (let y = 0; y < size; y++) { const v = l[y * size + x]; if (v === state) block++; else { if (block >= 5) result += block - 2; block = 1; state = v; } }
    if (block >= 5) result += block - 2;
  }
  for (let y = 0; y < size; y++) {
    let block = 0, state = 0;
    for (let x = 0; x < size; x++) { const v = l[y * size + x]; if (v === state) block++; else { if (block >= 5) result += block - 2; block = 1; state = v; } if (state) dark++; }
    if (block >= 5) result += block - 2;
  }
  for (let x = 0; x < size - 1; x++) for (let y = 0; y < size - 1; y++) {
    const k = l[y * size + x]; if (k === l[(y + 1) * size + x] && k === l[y * size + x + 1] && k === l[(y + 1) * size + x + 1]) result += 3;
  }
  const P = [1, 0, 1, 1, 1, 0, 1];
  const scan = (at: (i: number) => number) => {
    for (let s = 0; s <= size - 7; s++) {
      let ok = true; for (let q = 0; q < 7; q++) if (at(s + q) !== P[q]) { ok = false; break; }
      if (!ok) continue;
      let before = 0; for (let b = s - 1; b >= s - 4; b--) { if (b < 0) { before = 4; break; } if (at(b)) break; before++; }
      if (before === 4) result += 40;
      else { let after = 0; for (let a = s + 7; a <= s + 10; a++) { if (a >= size) { after = 4; break; } if (at(a)) break; after++; } if (after === 4) result += 40; }
      s += 3;
    }
  };
  for (let x = 0; x < size; x++) scan((i) => l[i * size + x]);
  for (let y = 0; y < size; y++) scan((i) => l[y * size + i]);
  result += 10 * Math.floor(Math.abs((100 * dark) / (size * size) - 50) / 5);
  return result;
}

const QR_MASKS: ((y: number, x: number) => boolean)[] = [
  (y, x) => ((y + x) & 1) === 0, (y) => (y & 1) === 0, (_y, x) => x % 3 === 0, (y, x) => (y + x) % 3 === 0,
  (y, x) => ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0, (y, x) => (y * x) % 6 === 0,
  (y, x) => ((((y * x) & 1) + ((y * x) % 3)) & 1) === 0, (y, x) => ((((y + x) & 1) + ((y * x) % 3)) & 1) === 0,
];

function toRows(g: number[], size: number): boolean[][] {
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) { const r: boolean[] = []; for (let x = 0; x < size; x++) r.push((g[y * size + x] & 1) === 1); rows.push(r); }
  return rows;
}

/** BARCODE_QRCODE with option_1 = ecc + 1 (0 L, 1 M, 2 Q, 3 H). */
export function qrCode(text: string, ecc: number): Barcode2DResult {
  if (!text) return { error: "No input data" };
  const inp = qrInput(text, true)!; const { d, eci } = inp;
  const binlen = (v: number) => qrStream(d, v, eci).bits.length;
  let est = binlen(40);
  if (est > 8 * QR_DATA_CW[ecc][39]) return { error: `Input too long for ECC level ${"LMQH"[ecc]}, requires ${Math.ceil(est / 8)} codewords (maximum ${QR_DATA_CW[ecc][39]})` };
  let version = 40;
  for (let i = 39; i >= 0; i--) if (8 * QR_DATA_CW[ecc][i] >= est) version = i + 1;
  if (version !== 40) est = binlen(version);
  while (version > 1) { const e = binlen(version - 1); if (8 * QR_DATA_CW[ecc][version - 2] < e) break; version--; est = e; }
  const { bits } = qrStream(d, version, eci);
  const dataCw = QR_DATA_CW[ecc][version - 1], cap = dataCw * 8;
  const term = Math.min(4, cap - bits.length); bits.put(0, term);
  while (bits.length % 8) bits.b.push(0);
  for (let p = 0; bits.length < cap; p++) bits.put(p & 1 ? 0x11 : 0xec, 8);
  const data: number[] = []; for (let i = 0; i < dataCw; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits.b[i * 8 + j]; data.push(v); }
  // qr_add_ecc: short blocks first, data then check symbols interleaved
  const blocks = QR_BLOCKS[ecc][version - 1], eccCw = QR_TOTAL_CW[version - 1] - dataCw;
  const shortLen = Math.floor(dataCw / blocks), longCount = dataCw % blocks, shortCount = blocks - longCount, eccLen = eccCw / blocks;
  const dBlocks: number[][] = [], eBlocks: number[][] = []; let pos = 0;
  for (let i = 0; i < blocks; i++) { const len = shortLen + (i < shortCount ? 0 : 1); const blk = data.slice(pos, pos + len); pos += len; dBlocks.push(blk); eBlocks.push(rsEncode(GF_QR, blk, eccLen, 0)); }
  const stream: number[] = [];
  for (let j = 0; j <= shortLen; j++) for (let i = 0; i < blocks; i++) if (j < dBlocks[i].length) stream.push(dBlocks[i][j]);
  for (let j = 0; j < eccLen; j++) for (let i = 0; i < blocks; i++) stream.push(eBlocks[i][j]);
  const { size, g } = qrFunctionGrid(version);
  // qr_populate_grid
  const n = stream.length * 8, bit = (i: number) => (stream[i >> 3] >> (7 - (i & 7))) & 1;
  let dir = 1, col = 0, y = size - 1, i = 0;
  while (i < n) {
    let x = size - 2 - col * 2; if (x < 6) x--;
    if (!(g[y * size + x + 1] & 0xf0)) { g[y * size + x + 1] = bit(i); i++; }
    if (i < n && !(g[y * size + x] & 0xf0)) { g[y * size + x] = bit(i); i++; }
    if (dir) { y--; if (y === -1) { col++; y = 0; dir = 0; } } else { y++; if (y === size) { col++; y = size - 1; dir = 1; } }
  }
  let best = 0, bestPen = Infinity;
  for (let p = 0; p < 8; p++) {
    const l = g.map((v, k) => { const yy = Math.floor(k / size), xx = k % size; return !(v & 0xf0) && QR_MASKS[p](yy, xx) ? (v ^ 1) & 1 : v & 0x0f; });
    qrFormatInto(l, size, ecc, p);
    for (let k = 0; k < l.length; k++) l[k] &= 1;
    const pen = qrPenalty(l, size); if (pen < bestPen) { bestPen = pen; best = p; }
  }
  for (let k = 0; k < g.length; k++) if (!(g[k] & 0xf0) && QR_MASKS[best](Math.floor(k / size), k % size)) g[k] ^= 1;
  qrFormatInto(g, size, ecc, best);
  return { rows: toRows(g, size) };
}

/** BARCODE_MICROQR with option_1 = ecc + 1 (0 L, 1 M, 2 Q; H is not available). */
export function microQrCode(text: string, ecc: number): Barcode2DResult {
  if (!text) return { error: "No input data" };
  if (ecc >= 3) return { error: "Error correction level H not available" };
  const inp = qrInput(text, false);
  if (!inp) return { error: "This barcode type does not support international characters. Use QR Code or Data Matrix instead." };
  const d = inp.d;
  if (d.length > 35) return { error: `Input length ${d.length} too long (maximum 35)` };
  let alpha = false, byte = false;
  for (const c of d) { if (c >= 48 && c <= 57) continue; if (c < 128 && QR_ALPHA.includes(String.fromCharCode(c))) alpha = true; else byte = true; }
  const valid = [true, true, true, true];
  if (byte) valid[0] = valid[1] = false; else if (alpha) valid[0] = false;
  if (ecc === 2) valid[0] = valid[1] = valid[2] = false; else if (ecc === 1) valid[0] = false;
  const count = [0, 1, 2, 3].map((i) => valid[i] ? qrStream(d, -(i + 1), 0).bits.length : 129);
  if (count[3] > MQR_DATA[ecc][3][0]) return { error: `Input too long for Version M4-${"LMQ"[ecc]}, requires ${Math.ceil(count[3] / 8)} codewords (maximum ${MQR_DATA[ecc][3][1]})` };
  for (let i = 0; i < 3; i++) if (count[i] > MQR_DATA[ecc][i][0]) valid[i] = false;
  let version = 3; for (let i = 2; i >= 0; i--) if (valid[i]) version = i;
  const bits = qrStream(d, -(version + 1), 0).bits;
  // microqr_end
  const [bitsTotal, dataCw, eccCw] = MQR_DATA[ecc][version], termBits = 3 + version * 2, bitsEnd = version === 0 || version === 2 ? 4 : 8;
  let left = bitsTotal - bits.length;
  if (left <= termBits) { if (left) { bits.put(0, left); left = 0; } } else { bits.put(0, termBits); left -= termBits; }
  if (bitsEnd === 4 && left && left <= 4) { bits.put(0, left); left = 0; }
  if (left) {
    let rem = 8 - (bits.length % 8); if (rem !== 8) { bits.put(0, rem); left -= rem; }
    if (bitsEnd === 4 && left > 4) left -= 4;
    rem = Math.floor(left / 8); for (let i = 0; i < rem; i++) bits.put(i & 1 ? 0x11 : 0xec, 8);
    if (bitsEnd === 4) bits.put(0, 4);
  }
  const data: number[] = [];
  for (let i = 0; i < dataCw; i++) { const nb = i + 1 === dataCw ? bitsEnd : 8; let v = 0; for (let j = 0; j < nb; j++) if (bits.b[i * 8 + j]) v |= 0x80 >> j; data.push(v); }
  const ecw = rsEncode(GF_QR, data, eccCw, 0); for (const e of ecw) bits.put(e, 8);
  const bp = bits.length, size = 11 + 2 * version, g = new Array<number>(size * size).fill(0);
  for (let i = 0; i < size; i++) { const t = i % 2 === 0 ? 0x21 : 0x20; g[i] = t; g[i * size] = t; }
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) g[r * size + c] = (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 0x11 : 0x10;
  for (let i = 0; i < 7; i++) { g[7 * size + i] = 0x10; g[i * size + 7] = 0x10; }
  g[7 * size + 7] = 0x10;
  for (let i = 0; i < 8; i++) { g[8 * size + i] |= 0x20; g[i * size + 8] |= 0x20; }
  g[8 * size + 8] |= 20;
  // microqr_populate_grid
  let dir = 1, col = 0, y = size - 1, i = 0;
  do {
    const x = size - 2 - col * 2;
    if (!(g[y * size + x + 1] & 0xf0)) { g[y * size + x + 1] = bits.b[i]; i++; }
    if (i < bp && !(g[y * size + x] & 0xf0)) { g[y * size + x] = bits.b[i]; i++; }
    if (dir) y--; else y++;
    if (y === 0) { col++; y = 1; dir = 0; }
    if (y === size) { col++; y = size - 1; dir = 1; }
  } while (i < bp);
  const MQ_MASKS: ((y: number, x: number) => boolean)[] = [QR_MASKS[1], QR_MASKS[4], QR_MASKS[6], QR_MASKS[7]];
  const darkAfter = (k: number, p: number) => { const v = g[k]; const m = !(v & 0xf0) && MQ_MASKS[p](Math.floor(k / size), k % size); return ((v & 1) === 1) !== m; };
  let best = 0, bestVal = -1;
  for (let p = 0; p < 4; p++) {
    let s1 = 0, s2 = 0;
    for (let k = 1; k < size; k++) { if (darkAfter(k * size + size - 1, p)) s1++; if (darkAfter((size - 1) * size + k, p)) s2++; }
    const val = s1 <= s2 ? s1 * 16 + s2 : s2 * 16 + s1;
    if (val > bestVal) { bestVal = val; best = p; }
  }
  for (let k = 0; k < g.length; k++) if (!(g[k] & 0xf0) && MQ_MASKS[best](Math.floor(k / size), k % size)) g[k] ^= 1;
  const format = version ? (version - 1) * 2 + ecc + 1 : 0, full = MQR_FORMAT[(format << 2) + best];
  for (let k = 1; k <= 8; k++) g[8 * size + k] |= (full >> (15 - k)) & 1;
  for (let k = 7; k >= 1; k--) g[k * size + 8] |= (full >> (k - 1)) & 1;
  return { rows: toRows(g, size) };
}

// ---- Data Matrix ECC 200 (dmatrix.c) ----
// [rows, cols, region rows (FH), region cols (FW), data codewords, data per block, ecc per block, DMRE]
const DM_SIZES: [number, number, number, number, number, number, number, number][] = [
  [10, 10, 10, 10, 3, 3, 5, 0], [12, 12, 12, 12, 5, 5, 7, 0], [8, 18, 8, 18, 5, 5, 7, 0], [14, 14, 14, 14, 8, 8, 10, 0],
  [8, 32, 8, 16, 10, 10, 11, 0], [16, 16, 16, 16, 12, 12, 12, 0], [12, 26, 12, 26, 16, 16, 14, 0], [18, 18, 18, 18, 18, 18, 14, 0],
  [8, 48, 8, 24, 18, 18, 15, 1], [20, 20, 20, 20, 22, 22, 18, 0], [12, 36, 12, 18, 22, 22, 18, 0], [8, 64, 8, 16, 24, 24, 18, 1],
  [22, 22, 22, 22, 30, 30, 20, 0], [16, 36, 16, 18, 32, 32, 24, 0], [8, 80, 8, 20, 32, 32, 22, 1], [24, 24, 24, 24, 36, 36, 24, 0],
  [8, 96, 8, 24, 38, 38, 28, 1], [12, 64, 12, 16, 43, 43, 27, 1], [26, 26, 26, 26, 44, 44, 28, 0], [20, 36, 20, 18, 44, 44, 28, 1],
  [16, 48, 16, 24, 49, 49, 28, 0], [8, 120, 8, 20, 49, 49, 32, 1], [20, 44, 20, 22, 56, 56, 34, 1], [32, 32, 16, 16, 62, 62, 36, 0],
  [16, 64, 16, 16, 62, 62, 36, 1], [8, 144, 8, 24, 63, 63, 36, 1], [12, 88, 12, 22, 64, 64, 36, 1], [26, 40, 26, 20, 70, 70, 38, 1],
  [22, 48, 22, 24, 72, 72, 38, 1], [24, 48, 24, 24, 80, 80, 41, 1], [20, 64, 20, 16, 84, 84, 42, 1], [36, 36, 18, 18, 86, 86, 42, 0],
  [26, 48, 26, 24, 90, 90, 42, 1], [24, 64, 24, 16, 108, 108, 46, 1], [40, 40, 20, 20, 114, 114, 48, 0], [26, 64, 26, 16, 118, 118, 50, 1],
  [44, 44, 22, 22, 144, 144, 56, 0], [48, 48, 24, 24, 174, 174, 68, 0], [52, 52, 26, 26, 204, 102, 42, 0], [64, 64, 16, 16, 280, 140, 56, 0],
  [72, 72, 18, 18, 368, 92, 36, 0], [80, 80, 20, 20, 456, 114, 48, 0], [88, 88, 22, 22, 576, 144, 56, 0], [96, 96, 24, 24, 696, 174, 68, 0],
  [104, 104, 26, 26, 816, 136, 56, 0], [120, 120, 20, 20, 1050, 175, 68, 0], [132, 132, 22, 22, 1304, 163, 62, 0], [144, 144, 24, 24, 1558, 156, 62, 0],
];

// ---- Zint's minimal encodation (dm_minimalenc, dm_define_mode, dm_encode) ----
const DM_ASCII = 1, DM_C40 = 2, DM_TEXT = 3, DM_X12 = 4, DM_EDIFACT = 5, DM_BASE256 = 6, DM_NUM_MODES = 6;
const tbl = (s: string): number[] => s.split(",").map(Number);
// dm_c40_shift / dm_c40_value / dm_text_shift / dm_text_value (Tables C.1 and C.2)
const DM_C40_SHIFT = tbl("1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3");
const DM_C40_VALUE = tbl("0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,3,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,4,5,6,7,8,9,10,11,12,13,15,16,17,18,19,20,21,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,22,23,24,25,26,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31");
const DM_TEXT_SHIFT = tbl("1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,0,0,0,0,0,0,0,0,0,0,2,2,2,2,2,2,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,2,2,2,2,2,3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,3,3,3,3");
const DM_TEXT_VALUE = tbl("0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,3,0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,4,5,6,7,8,9,10,11,12,13,15,16,17,18,19,20,21,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,22,23,24,25,26,0,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,27,28,29,30,31");
const isDigit = (c: number): boolean => c >= 48 && c <= 57, isUpper = (c: number): boolean => c >= 65 && c <= 90, isLower = (c: number): boolean => c >= 97 && c <= 122;
const dmIsC40 = (c: number): boolean => (c <= 57 ? c >= 48 || c === 32 : isUpper(c));
const dmIsText = (c: number): boolean => (c <= 57 ? c >= 48 || c === 32 : isLower(c));
const dmIsC40Text = (mode: number, c: number): boolean => (mode === DM_C40 ? dmIsC40(c) : dmIsText(c));
const dmIsX12 = (c: number): boolean => dmIsC40(c) || c === 13 || c === 42 || c === 62;
const dmIsEdifact = (c: number): boolean => c >= 32 && c <= 94;
const twoDigits = (s: number[], i: number): boolean => i + 1 < s.length && isDigit(s[i]) && isDigit(s[i + 1]);
/** dm_get_symbolsize (automatic size, no DMRE): the smallest size holding `minimum` codewords */
function dmSymbolSize(minimum: number): number {
  if (minimum > 1304) return minimum <= 1558 ? DM_SIZES.length - 1 : 0;
  let i = minimum >= 62 ? 23 : 0;
  while (minimum > DM_SIZES[i][4]) i++;
  while (DM_SIZES[i][7]) i++;
  return i;
}
const dmRemaining = (tp: number, processP: number): number => DM_SIZES[dmSymbolSize(tp + processP)][4] - tp;
/** dm_last_ascii: 1 to 4 chars at the end that take 1 or 2 ASCII codewords */
function dmLastAscii(s: number[], from: number): number {
  const n = s.length;
  if (n - from > 4 || from >= n) return 0;
  if (n - from === 1) return s[from] & 0x80 ? 0 : 1;
  if (n - from === 2) { if ((s[from] & 0x80) || (s[from + 1] & 0x80)) return 0; return isDigit(s[from]) && isDigit(s[from + 1]) ? 1 : 2; }
  if (n - from === 3) {
    if (isDigit(s[from]) && isDigit(s[from + 1]) && !(s[from + 2] & 0x80)) return 2;
    if (isDigit(s[from + 1]) && isDigit(s[from + 2]) && !(s[from] & 0x80)) return 2;
    return 0;
  }
  return isDigit(s[from]) && isDigit(s[from + 1]) && isDigit(s[from + 2]) && isDigit(s[from + 3]) ? 2 : 0;
}
interface DmEdge { mode: number; endMode: number; from: number; len: number; size: number; bytes: number; previous: DmEdge | null }
/** dm_getNumberOfC40Words: codewords for whole C40/Text triplets from `from` (or to the end); [cwds, chars] */
function dmC40Words(s: number[], from: number, mode: number): [number, number] {
  let thirds = 0;
  for (let i = from; i < s.length; i++) {
    const ci = s[i];
    if (dmIsC40Text(mode, ci)) thirds++; else if (!(ci & 0x80)) thirds += 2; else if (dmIsC40Text(mode, ci & 0x7f)) thirds += 3; else thirds += 4;
    const rem = thirds % 3;
    if (rem === 0 || (rem === 2 && i + 1 === s.length)) return [Math.floor((thirds + 2) / 3) * 2, i - from + 1];
  }
  return [0, 0];
}
/** dm_new_Edge */
function dmNewEdge(s: number[], mode: number, from: number, len: number, previous: DmEdge | null, cwds: number): DmEdge {
  const n = s.length;
  const e: DmEdge = { mode, endMode: mode, from, len, size: 0, bytes: 0, previous };
  const prevMode = previous ? previous.endMode : DM_ASCII;
  let size = previous ? previous.size : 0;
  const unlatch = (): void => { if (prevMode !== DM_ASCII && prevMode !== DM_BASE256) size++; };
  switch (mode) {
    case DM_ASCII: size++; if (s[from] & 0x80) size++; unlatch(); break;
    case DM_BASE256:
      size++;
      if (prevMode !== DM_BASE256) { size += 2; unlatch(); e.bytes = 1; }
      else { e.bytes = 1 + previous!.bytes; if (e.bytes === 250) size++; }
      break;
    case DM_C40: case DM_TEXT:
      size += cwds;
      if (prevMode !== mode) { size++; unlatch(); }
      if (from + len + 2 >= n) { const la = dmLastAscii(s, from + len); if (dmRemaining(size + la, 0) > 0) size++; }
      break;
    case DM_X12:
      size += 2;
      if (prevMode !== DM_X12) { size++; unlatch(); }
      if (from + len + 2 >= n) { const la = dmLastAscii(s, from + len); if (la === 2) size++; else if (dmRemaining(size + la, 0) > 0) size++; }
      break;
    case DM_EDIFACT:
      size += 3;
      if (prevMode !== DM_EDIFACT) { size++; unlatch(); }
      // dm_getEndMode
      if (len < 4) e.endMode = DM_ASCII;
      else { const la = dmLastAscii(s, from + len); if (la && dmRemaining(size + la, 0) <= 2 - la) e.endMode = DM_ASCII; }
      break;
  }
  e.size = size;
  return e;
}
/** dm_define_mode: the cheapest mode per input character (Alex Geller's Dijkstra-based search) */
function dmDefineModes(s: number[]): number[] {
  const n = s.length, edges: (DmEdge | null)[] = new Array((n + 1) * DM_NUM_MODES).fill(null);
  const add = (mode: number, from: number, len: number, prev: DmEdge | null, cwds: number): void => {
    const e = dmNewEdge(s, mode, from, len, prev, cwds), k = (from + len) * DM_NUM_MODES + e.endMode - 1;
    if (!edges[k] || edges[k]!.size > e.size) edges[k] = e;
  };
  const addEdges = (from: number, prev: DmEdge | null): void => {
    if (!prev || prev.endMode !== DM_EDIFACT) {
      if (isDigit(s[from]) && from + 1 < n && isDigit(s[from + 1])) { add(DM_ASCII, from, 2, prev, 0); if (prev && prev.mode === DM_ASCII) return; }
      else add(DM_ASCII, from, 1, prev, 0);
      for (const m of [DM_C40, DM_TEXT]) { const [cwds, len] = dmC40Words(s, from, m); if (cwds) add(m, from, len, prev, cwds); }
      if (from + 2 < n && dmIsX12(s[from]) && dmIsX12(s[from + 1]) && dmIsX12(s[from + 2])) add(DM_X12, from, 3, prev, 0);
      add(DM_BASE256, from, 1, prev, 0);
    }
    if (dmIsEdifact(s[from])) for (let i = 1, pos = from + 1; i < 4 && pos < n && dmIsEdifact(s[pos]); i++, pos++) add(DM_EDIFACT, from, i + 1, prev, 0);
  };
  addEdges(0, null);
  for (let i = 1; i < n; i++) for (let j = 0; j < DM_NUM_MODES; j++) { const e = edges[i * DM_NUM_MODES + j]; if (e) addEdges(i, e); }
  let best: DmEdge | null = null;
  for (let j = 0; j < DM_NUM_MODES; j++) { const e = edges[n * DM_NUM_MODES + j]; if (e && (!best || e.size < best.size)) best = e; }
  const modes = new Array<number>(n).fill(0);
  for (let e = best; e; e = e.previous) for (let i = e.from; i < e.from + e.len; i++) modes[i] = e.mode;
  return modes;
}
/** dm_ctx_buffer_xfer: whole C40 / Text / X12 triplets out of the buffer */
function dmCtxXfer(buf: number[], t: number[]): void {
  const e = Math.floor(buf.length / 3) * 3;
  for (let i = 0; i < e; i += 3) { const iv = 1600 * buf[i] + 40 * buf[i + 1] + buf[i + 2] + 1; t.push(iv >> 8, iv & 0xff); }
  buf.splice(0, e);
}
/** dm_edi_buffer_xfer: whole EDIFACT quadruplets out of the buffer; `empty` flushes the rest */
function dmEdiXfer(buf: number[], t: number[], empty: boolean): void {
  const e = Math.floor(buf.length / 4) * 4;
  for (let i = 0; i < e; i += 4) t.push(((buf[i] << 2) | ((buf[i + 1] & 0x30) >> 4)) & 0xff, (((buf[i + 1] & 0x0f) << 4) | ((buf[i + 2] & 0x3c) >> 2)) & 0xff, (((buf[i + 2] & 0x03) << 6) | buf[i + 3]) & 0xff);
  buf.splice(0, e);
  if (buf.length && empty) {
    if (buf.length === 3) t.push(((buf[0] << 2) | ((buf[1] & 0x30) >> 4)) & 0xff, (((buf[1] & 0x0f) << 4) | ((buf[2] & 0x3c) >> 2)) & 0xff, ((buf[2] & 0x03) << 6) & 0xff);
    else if (buf.length === 2) t.push(((buf[0] << 2) | ((buf[1] & 0x30) >> 4)) & 0xff, ((buf[1] & 0x0f) << 4) & 0xff);
    else t.push((buf[0] << 2) & 0xff);
    buf.length = 0;
  }
}
/** dm_update_b256_field_length, then B.2.1's 255-state randomising of the Base 256 field */
function dmB256Close(t: number[], start: number, fieldLength: boolean): void {
  if (fieldLength) {
    const count = t.length - (start + 1);
    if (count <= 249) t[start] = count;
    else { t.splice(start + 1, 0, count % 250); t[start] = 249 + Math.floor(count / 250); }
  }
  for (let i = start; i < t.length; i++) t[i] = (t[i] + ((149 * (i + 1)) % 255) + 1) & 0xff;
}
const asciiCw = (t: number[], s: number[], sp: number): number => {
  if (twoDigits(s, sp)) { t.push(10 * (s[sp] - 48) + (s[sp + 1] - 48) + 130); return 2; }
  if (s[sp] & 0x80) t.push(235, s[sp] - 128 + 1); else t.push(s[sp] + 1);
  return 1;
};
/** dm_encode_segs + dm_encode for one segment: ECI, the Macro 05 / 06 header, minimal encodation, the end of data */
function dmEncode(s: number[], eci: number): number[] | string {
  const t: number[] = [];
  if (s.length > 3116) return `Input length ${s.length} too long (maximum 3116)`;
  // "[)>RS05GS...RSEOT" -> 236, "[)>RS06GS...RSEOT" -> 237
  if (s.length >= 9 && s[0] === 91 && s[1] === 41 && s[2] === 62 && s[3] === 0x1e && s[4] === 48 && (s[5] === 53 || s[5] === 54) && s[6] === 0x1d && s[s.length - 1] === 0x04 && s[s.length - 2] === 0x1e) {
    t.push(s[5] === 53 ? 236 : 237); s = s.slice(7, s.length - 2);
  }
  if (eci > 0) {
    t.push(241);
    if (eci <= 126) t.push(eci + 1);
    else if (eci <= 16382) t.push(Math.floor((eci - 127) / 254) + 128, ((eci - 127) % 254) + 1);
    else t.push(Math.floor((eci - 16383) / 64516) + 192, (Math.floor((eci - 16383) / 254) % 254) + 1, ((eci - 16383) % 254) + 1);
  }
  const n = s.length, modes = n ? dmDefineModes(s) : [];
  const buf: number[] = [];
  let sp = 0, mode = DM_ASCII, b256Start = 0;
  while (sp < n) {
    if (modes[sp] !== mode) {
      if (mode === DM_C40 || mode === DM_TEXT || mode === DM_X12) { buf.length = 0; t.push(254); }
      else if (mode === DM_EDIFACT) {
        const la = dmLastAscii(s, sp);
        if (!la || dmRemaining(t.length + la, buf.length) > 2 - la) buf.push(31);
        dmEdiXfer(buf, t, true);
      } else if (mode === DM_BASE256) dmB256Close(t, b256Start, true);
      const next = modes[sp];
      if (next === DM_C40) t.push(230); else if (next === DM_TEXT) t.push(239); else if (next === DM_X12) t.push(238); else if (next === DM_EDIFACT) t.push(240);
      else if (next === DM_BASE256) { t.push(231); b256Start = t.length; t.push(0); }
    }
    mode = modes[sp];
    if (mode === DM_ASCII) sp += asciiCw(t, s, sp);
    else if (mode === DM_C40 || mode === DM_TEXT) {
      const sh = mode === DM_C40 ? DM_C40_SHIFT : DM_TEXT_SHIFT, va = mode === DM_C40 ? DM_C40_VALUE : DM_TEXT_VALUE;
      let c = s[sp];
      if (c & 0x80) { buf.push(1, 30); c -= 128; }   // Shift 2, Upper Shift
      if (sh[c]) buf.push(sh[c] - 1);
      buf.push(va[c]);
      if (buf.length >= 3) dmCtxXfer(buf, t);
      sp++;
    } else if (mode === DM_X12) {
      const c = s[sp];
      buf.push(isDigit(c) ? c - 48 + 4 : isUpper(c) ? c - 65 + 14 : "\r*> ".indexOf(String.fromCharCode(c)));
      if (buf.length >= 3) dmCtxXfer(buf, t);
      sp++;
    } else if (mode === DM_EDIFACT) {
      const c = s[sp++]; buf.push(c >= 64 ? c - 64 : c);
      if (buf.length >= 4) dmEdiXfer(buf, t, false);
    } else { t.push(s[sp++]); }
    if (t.length > 1558) return "Input too long, requires too many codewords (maximum 1558)";
  }
  // the end of data
  const left = dmRemaining(t.length, buf.length);
  if (mode === DM_C40 || mode === DM_TEXT) {
    if (!buf.length) { if (left > 0) t.push(254); }
    else if (buf.length === 2 && left === 2) { buf.push(0); dmCtxXfer(buf, t); }
    else if (buf.length === 1 && left <= 2 && dmIsC40Text(mode, s[n - 1])) { if (left > 1) t.push(254); t.push(s[n - 1] + 1); }
    else {
      // backtrack to the last whole triplet and finish in ASCII
      let p = buf.length, total = 0;
      while (sp > 0 && p % 3) {
        sp--;
        let c = s[sp], cnt = 1;
        if (c & 0x80) { cnt += 2; c -= 128; }
        if ((mode === DM_C40 && DM_C40_SHIFT[c]) || (mode === DM_TEXT && DM_TEXT_SHIFT[c])) cnt++;
        total += cnt; p -= cnt;
      }
      t.length -= Math.floor(total / 3) * 2;
      t.push(254);
      while (sp < n) sp += asciiCw(t, s, sp);
    }
  } else if (mode === DM_X12) {
    if (left === 1 && buf.length === 1) t.push(s[n - 1] + 1);
    else {
      if (left > 0) t.push(254);
      if (buf.length === 1) t.push(s[n - 1] + 1); else if (buf.length === 2) t.push(s[n - 2] + 1, s[n - 1] + 1);
    }
  } else if (mode === DM_EDIFACT) {
    if (left <= 2 && buf.length <= left) { if (buf.length === 1) t.push(s[n - 1] + 1); else if (buf.length === 2) t.push(s[n - 2] + 1, s[n - 1] + 1); }
    else { if (buf.length <= 3) buf.push(31); dmEdiXfer(buf, t, true); }
  } else if (mode === DM_BASE256) dmB256Close(t, b256Start, left > 0);
  return t;
}

/** ECC 200 module placement (ISO/IEC 16022 Annex F): codeword-bit ids per data-region module, 10 * chr + bit. */
function dmPlacement(nrow: number, ncol: number): number[] {
  const a = new Array<number>(nrow * ncol).fill(0);
  const mod = (r: number, c: number, chr: number, bit: number) => {
    if (r < 0) { r += nrow; c += 4 - ((nrow + 4) % 8); }
    if (c < 0) { c += ncol; r += 4 - ((ncol + 4) % 8); }
    a[r * ncol + c] = 10 * chr + bit;
  };
  const utah = (r: number, c: number, chr: number) => {
    mod(r - 2, c - 2, chr, 1); mod(r - 2, c - 1, chr, 2); mod(r - 1, c - 2, chr, 3); mod(r - 1, c - 1, chr, 4);
    mod(r - 1, c, chr, 5); mod(r, c - 2, chr, 6); mod(r, c - 1, chr, 7); mod(r, c, chr, 8);
  };
  const corner = (chr: number, pts: number[][]) => pts.forEach(([r, c], i) => mod(r, c, chr, i + 1));
  let chr = 1, r = 4, c = 0;
  do {
    if (r === nrow && c === 0) corner(chr++, [[nrow - 1, 0], [nrow - 1, 1], [nrow - 1, 2], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (r === nrow - 2 && c === 0 && ncol % 4) corner(chr++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 4], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1]]);
    if (r === nrow - 2 && c === 0 && ncol % 8 === 4) corner(chr++, [[nrow - 3, 0], [nrow - 2, 0], [nrow - 1, 0], [0, ncol - 2], [0, ncol - 1], [1, ncol - 1], [2, ncol - 1], [3, ncol - 1]]);
    if (r === nrow + 4 && c === 2 && !(ncol % 8)) corner(chr++, [[nrow - 1, 0], [nrow - 1, ncol - 1], [0, ncol - 3], [0, ncol - 2], [0, ncol - 1], [1, ncol - 3], [1, ncol - 2], [1, ncol - 1]]);
    do { if (r < nrow && c >= 0 && !a[r * ncol + c]) utah(r, c, chr++); r -= 2; c += 2; } while (r >= 0 && c < ncol);
    r += 1; c += 3;
    do { if (r >= 0 && c < ncol && !a[r * ncol + c]) utah(r, c, chr++); r += 2; c -= 2; } while (r < nrow && c >= 0);
    r += 3; c += 1;
  } while (r < nrow || c < ncol);
  if (!a[nrow * ncol - 1]) { a[nrow * ncol - 1] = 1; a[nrow * ncol - ncol - 2] = 1; }
  return a;
}

/** BARCODE_DATAMATRIX, automatic size (square and standard rectangular, no DMRE). */
export function dataMatrix(text: string): Barcode2DResult {
  if (!text) return { error: "No input data" };
  // PCB_BARCODE: UNICODE_MODE, and ECI 26 (UTF-8) for text that is not ASCII
  const ascii = [...text].every((c) => c.codePointAt(0)! < 128);
  const cw = dmEncode(ascii ? [...text].map((c) => c.charCodeAt(0)) : [...new TextEncoder().encode(text)], ascii ? 0 : 26);
  if (typeof cw === "string") return { error: cw };
  const si = dmSymbolSize(cw.length);
  if (cw.length > DM_SIZES[si][4]) return { error: `Input too long, requires ${cw.length} codewords (maximum 1558)` };
  const [H, W, FH, FW, bytes, dataBlock, rsBlock] = DM_SIZES[si];
  const data = cw.slice();
  if (data.length < bytes) {
    data.push(129);
    while (data.length < bytes) { let p = ((149 * (data.length + 1)) % 253) + 1 + 129; if (p > 254) p -= 254; data.push(p); }
  }
  // dm_ecc: interleaved blocks; 144x144 rotates its ECC codewords (Zint's default, not DM_ISO_144)
  const blocks = Math.floor((bytes + 2) / dataBlock), full = new Array<number>(bytes + blocks * rsBlock).fill(0), skew = H === 144;
  for (let i = 0; i < bytes; i++) full[i] = data[i];
  for (let b = 0; b < blocks; b++) {
    const blk: number[] = []; for (let n = b; n < bytes; n += blocks) blk.push(data[n]);
    const ecc = rsEncode(GF_DM, blk, rsBlock, 1);
    for (let n = b, p = 0; n < blocks * rsBlock; n += blocks, p++) full[bytes + n + (skew ? (b < 8 ? 2 : -8) : 0)] = ecc[p];
  }
  const NR = H - 2 * (H / FH), NC = W - 2 * (W / FW), place = dmPlacement(NR, NC);
  const rows: boolean[][] = []; for (let y = 0; y < H; y++) rows.push(new Array<boolean>(W).fill(false));
  for (let y = 0; y < H; y += FH) {
    for (let x = 0; x < W; x++) rows[y + FH - 1][x] = true;
    for (let x = 0; x < W; x += 2) rows[y][x] = true;
  }
  for (let x = 0; x < W; x += FW) {
    for (let y = 0; y < H; y++) rows[y][x] = true;
    for (let y = 0; y < H; y += 2) rows[y + 1][x + FW - 1] = true;
  }
  const rh = FH - 2, rw = FW - 2;
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
    const v = place[r * NC + c]; let dark: boolean;
    if (v === 1) dark = true; else if (v < 10) dark = false;
    else { const ch = Math.floor(v / 10) - 1, bit = v % 10; dark = ((full[ch] >> (8 - bit)) & 1) === 1; }
    const y = 1 + r + 2 * Math.floor(r / rh), x = 1 + c + 2 * Math.floor(c / rw);
    rows[y][x] = dark;
  }
  return { rows };
}

/** The symbol of a (barcode (type …)) for the 2D kinds; null for the 1D ones. */
export function barcode2D(type: string, text: string, ecc: number): Barcode2DResult | null {
  if (type === "qr") return qrCode(text, ecc);
  if (type === "microqr") return microQrCode(text, Math.min(ecc, 2));
  if (type === "datamatrix") return dataMatrix(text);
  return null;
}
