// exchange-zip.ts — a small ZIP writer for the container formats (3MF).  Entries are deflated with the
// platform's CompressionStream when it has one (browsers, workers, node ≥ 18) and stored otherwise.  Pure.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CS("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) { return null; }
}

export interface ZipEntry { name: string; data: Uint8Array }

/** A ZIP archive of the entries, in the order given. */
export async function zip(entries: readonly ZipEntry[], o: { compress?: boolean } = {}): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const packed = o.compress === false ? null : await deflateRaw(e.data);
    const useDeflate = !!packed && packed.length < e.data.length;
    const body = useDeflate ? packed! : e.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, useDeflate ? 8 : 0, true);
    lv.setUint16(10, 0, true); lv.setUint16(12, 0x21, true); lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
    const head = new Uint8Array(46 + name.length);
    const cv = new DataView(head.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, useDeflate ? 8 : 0, true);
    cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); head.set(name, 46);
    parts.push(local, body); central.push(head);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

/** The entries of a ZIP archive (stored or deflated), for tests and for reading 3MF back. */
export async function unzip(data: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = data.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip archive");
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(data.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    let body = data.subarray(start, start + size);
    if (method === 8) {
      const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream!;
      body = new Uint8Array(await new Response(new Blob([body as BlobPart]).stream().pipeThrough(new DS("deflate-raw"))).arrayBuffer());
    }
    out.push({ name, data: body });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
