// library/embedded-file — EMBEDDED_FILES::AddFile and WriteEmbeddedFiles for one file (common/embedded_files.cpp):
//   embeddedFileType    the (type …) AddFile picks from the extension (model / font / datasheet / worksheet / other)
//   mmh3Hash            MMH3_HASH( EMBEDDED_FILES::Seed() ) over the bytes, HASH_128::ToString's 32 upper-case hex digits
//   embeddedFileSexpr   the (file (name …) (type …) (data |…|) (checksum …)) form: the bytes compressed into a zstd frame
//                       with its content size (CompressAndEncode's ZSTD_compress, dialogs/zstd-compress.ts), base64 in
//                       MIME_BASE64_LENGTH lines
//   embeddedFileData    where a board footprint's file content is: a board KiCad saved (CTL_FOR_BOARD) writes each
//                       footprint's files without data and keeps the data once in the board's own (embedded_files …),
//                       which BOARD::FixupEmbeddedData copies back into the footprints by name on load
//   fixupEmbeddedData   that copy, onto a footprint node
//   decodeEmbedded      DecompressAndDecode: the bytes of a (data |…|)

import { zstdCompress } from "../dialogs/zstd-compress";
import { zstdDecompress } from "../dialogs/zstd";

/** EMBEDDED_FILES::Seed */
export const EMBED_SEED = 0xabba2345;
/** MIME_BASE64_LENGTH: the width of one line of (data …) */
const LINE = 76;

/** EMBEDDED_FILES::AddFile: the file type from its extension. */
export function embeddedFileType(name: string): "model" | "font" | "datasheet" | "worksheet" | "other" {
  const ext = (/\.([^./\\]+)$/.exec(name) || ["", ""])[1].toUpperCase();
  if (["STP", "STPZ", "STEP", "WRL", "WRZ"].includes(ext)) return "model";
  if (["WOFF", "WOFF2", "TTF", "OTF"].includes(ext)) return "font";
  if (ext === "PDF") return "datasheet";
  if (ext === "KICAD_WKS") return "worksheet";
  return "other";
}

const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & M64;
const fmix = (k: bigint): bigint => {
  k ^= k >> 33n; k = (k * 0xff51afd7ed558ccdn) & M64; k ^= k >> 33n; k = (k * 0xc4ceb9fe1a85ec53n) & M64; k ^= k >> 33n; return k;
};
/** MurmurHash3_x64_128 (MMH3_HASH::addData, then digest) as HASH_128::ToString writes it. */
export function mmh3Hash(data: Uint8Array, seed = EMBED_SEED): string {
  const C1 = 0x87c37b91114253d5n, C2 = 0x4cf5ad432745937fn;
  let h1 = BigInt(seed >>> 0), h2 = BigInt(seed >>> 0);
  const le64 = (p: number, n: number): bigint => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(data[p + i]); return v; };
  const nblocks = Math.floor(data.length / 16);
  for (let b = 0; b < nblocks; b++) {
    let k1 = le64(b * 16, 8), k2 = le64(b * 16 + 8, 8);
    k1 = (k1 * C1) & M64; k1 = rotl(k1, 31n); k1 = (k1 * C2) & M64; h1 ^= k1;
    h1 = rotl(h1, 27n); h1 = (h1 + h2) & M64; h1 = (h1 * 5n + 0x52dce729n) & M64;
    k2 = (k2 * C2) & M64; k2 = rotl(k2, 33n); k2 = (k2 * C1) & M64; h2 ^= k2;
    h2 = rotl(h2, 31n); h2 = (h2 + h1) & M64; h2 = (h2 * 5n + 0x38495ab5n) & M64;
  }
  const t = nblocks * 16, rest = data.length & 15;
  if (rest > 8) { let k2 = le64(t + 8, rest - 8); k2 = (k2 * C2) & M64; k2 = rotl(k2, 33n); k2 = (k2 * C1) & M64; h2 ^= k2; }
  if (rest > 0) { let k1 = le64(t, Math.min(rest, 8)); k1 = (k1 * C1) & M64; k1 = rotl(k1, 31n); k1 = (k1 * C2) & M64; h1 ^= k1; }
  const len = BigInt(data.length >>> 0);   // MMH3_HASH::len is a uint32_t
  h1 ^= len; h2 ^= len; h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  h1 = fmix(h1); h2 = fmix(h2); h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  return (h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")).toUpperCase();
}

function base64(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';

/** WriteEmbeddedFiles for one file: the form to put in (embedded_files …). */
export function embeddedFileSexpr(name: string, data: Uint8Array): string {
  const enc = base64(zstdCompress(data)), lines: string[] = [];
  for (let i = 0; i < enc.length; i += LINE) lines.push(enc.slice(i, i + LINE));
  return `(file (name ${quote(name)}) (type ${embeddedFileType(name)}) (data |${lines.join("\n")}|) (checksum ${quote(mmh3Hash(data))}))`;
}

type Node = unknown[];
const isList = Array.isArray;
const child = (n: Node, key: string): Node | null => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === key) return c as Node; } return null; };
/** The (file …) of `files` (an (embedded_files …) node) named `name`. */
export function embeddedFileNode(files: Node | null | undefined, name: string): Node | null {
  if (!files) return null;
  for (let j = 1; j < files.length; j++) { const c = files[j]; if (isList(c) && c[0] === "file" && String((child(c as Node, "name") || [])[1] ?? "") === name) return c as Node; }
  return null;
}
/** The base64 text of a (file …)'s (data |…|), or null when it carries none. */
export function fileData(file: Node | null): string | null {
  const d = file ? child(file, "data") : null; if (!d) return null;
  const b64 = d.slice(1).map((x) => String(x)).join("").replace(/[|\s]/g, "");
  return b64 || null;
}
/**
 * The data of `owner`'s (a footprint's) embedded file `name` as KiCad has it after loading the board: the board's own
 * file of that name when there is one (FixupEmbeddedData), else the footprint's.  `boardFiles` is the board's
 * top-level (embedded_files …).
 */
export function embeddedFileData(owner: Node, name: string, boardFiles?: Node | null): string | null {
  const own = embeddedFileNode(child(owner, "embedded_files"), name); if (!own) return null;
  return fileData(embeddedFileNode(boardFiles, name)) ?? fileData(own);
}
/** EMBEDDED_FILES::DecompressAndDecode: base64, then the zstd frame; null when it does not read. */
export function decodeEmbedded(b64: string | null): Uint8Array | null {
  if (!b64) return null;
  try { const bin = atob(b64), raw = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i); return zstdDecompress(raw); } catch { return null; }
}
/**
 * BOARD::FixupEmbeddedData on one footprint node: each of its files the board also has takes the board's data and
 * checksum.  The (data …) and (checksum …) nodes are the board's own, shared (not copied, so the quoting marks the
 * reader keeps beside them hold): meant for a copy that is read or written out, not edited further.
 */
export function fixupEmbeddedData(fp: Node, boardFiles: Node | null | undefined): boolean {
  const ef = child(fp, "embedded_files"); if (!ef || !boardFiles) return false;
  let did = false;
  for (let j = 1; j < ef.length; j++) {
    const f = ef[j]; if (!isList(f) || f[0] !== "file") continue;
    const b = embeddedFileNode(boardFiles, String((child(f as Node, "name") || [])[1] ?? "")); const d = b ? child(b, "data") : null; if (!b || !d) continue;
    const g = (f as Node).filter((c) => !(isList(c) && (c[0] === "data" || c[0] === "checksum")));
    const sum = child(b, "checksum");
    g.push(d); if (sum) g.push(sum);
    ef[j] = g; did = true;
  }
  return did;
}
